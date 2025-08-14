import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import numpy as np
from collections import Counter
import re

# 设置中文字体
plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

def load_and_clean_data(csv_file="boss_jobs.csv"):
    """
    加载并清理CSV数据
    
    Args:
        csv_file (str): CSV文件名
        
    Returns:
        pd.DataFrame: 清理后的数据
    """
    try:
        # 读取CSV文件
        df = pd.read_csv(csv_file, encoding='utf-8-sig')
        print(f"成功加载数据，共 {len(df)} 条记录")
        
        # 清理学历要求列
        df['学历要求'] = df['学历要求'].fillna('未知')
        
        # 清理薪资列
        df['薪资'] = df['薪资'].fillna('未知')
        
        return df
        
    except Exception as e:
        print(f"加载数据时出错: {e}")
        return None

def extract_salary_range(salary_str):
    """
    从薪资字符串中提取薪资范围
    
    Args:
        salary_str (str): 薪资字符串，如"10-15K"
        
    Returns:
        tuple: (最低薪资, 最高薪资, 平均薪资)
    """
    if pd.isna(salary_str) or salary_str == '未知':
        return None, None, None
    
    # 匹配薪资模式
    patterns = [
        r'(\d+)-(\d+)K',  # 10-15K
        r'(\d+)-(\d+)k',  # 10-15k
        r'(\d+)K-(\d+)K', # 10K-15K
        r'(\d+)k-(\d+)k', # 10k-15k
        r'(\d+)K',         # 15K
        r'(\d+)k',         # 15k
    ]
    
    for pattern in patterns:
        match = re.search(pattern, salary_str)
        if match:
            if len(match.groups()) == 2:
                min_salary = int(match.group(1))
                max_salary = int(match.group(2))
                avg_salary = (min_salary + max_salary) / 2
                return min_salary, max_salary, avg_salary
            else:
                salary = int(match.group(1))
                return salary, salary, salary
    
    return None, None, None

def analyze_education_salary(df):
    """
    分析不同学历的薪资情况
    
    Args:
        df (pd.DataFrame): 数据框
        
    Returns:
        dict: 分析结果
    """
    # 提取薪资信息
    salary_data = []
    for _, row in df.iterrows():
        min_sal, max_sal, avg_sal = extract_salary_range(row['薪资'])
        if avg_sal is not None:
            salary_data.append({
                '学历要求': row['学历要求'],
                '工作经验': row['工作经验'],
                '最低薪资': min_sal,
                '最高薪资': max_sal,
                '平均薪资': avg_sal,
                '薪资范围': row['薪资']
            })
    
    salary_df = pd.DataFrame(salary_data)
    
    # 按学历分组统计
    education_stats = salary_df.groupby('学历要求').agg({
        '平均薪资': ['mean', 'median', 'count'],
        '最低薪资': 'mean',
        '最高薪资': 'mean'
    }).round(2)
    
    # 重命名列
    education_stats.columns = ['平均薪资', '中位数薪资', '职位数量', '平均最低薪资', '平均最高薪资']
    
    return education_stats, salary_df

def analyze_education_experience_salary(salary_df):
    """
    分析不同学历和工作经验组合的薪资情况
    
    Args:
        salary_df (pd.DataFrame): 包含薪资数据的数据框
        
    Returns:
        pd.DataFrame: 交叉分析结果
    """
    # 按学历和工作经验分组统计
    cross_stats = salary_df.groupby(['学历要求', '工作经验']).agg({
        '平均薪资': ['mean', 'median', 'count']
    }).round(2)
    
    # 重命名列
    cross_stats.columns = ['平均薪资', '中位数薪资', '职位数量']
    
    # 创建透视表用于热力图
    median_pivot = salary_df.pivot_table(
        values='平均薪资', 
        index='学历要求', 
        columns='工作经验', 
        aggfunc='median',
        fill_value=0
    ).round(2)
    
    # 创建职位数量透视表
    count_pivot = salary_df.pivot_table(
        values='平均薪资', 
        index='学历要求', 
        columns='工作经验', 
        aggfunc='count',
        fill_value=0
    )
    
    return cross_stats, median_pivot, count_pivot

def create_visualizations(df, education_stats, salary_df, cross_stats, median_pivot, count_pivot):
    """
    创建可视化图表
    
    Args:
        df (pd.DataFrame): 原始数据
        education_stats (pd.DataFrame): 学历统计
        salary_df (pd.DataFrame): 薪资数据
        cross_stats (pd.DataFrame): 交叉统计
        median_pivot (pd.DataFrame): 中位数透视表
        count_pivot (pd.DataFrame): 职位数量透视表
    """
    # 创建子图
    fig, axes = plt.subplots(3, 2, figsize=(20, 18))
    fig.suptitle('BOSS直聘职位数据分析 - 学历与工作经验薪资分析', fontsize=18, fontweight='bold')
    
    # 1. 不同学历的职位数量分布
    ax1 = axes[0, 0]
    education_counts = df['学历要求'].value_counts()
    colors = plt.cm.Set3(np.linspace(0, 1, len(education_counts)))
    
    wedges, texts, autotexts = ax1.pie(education_counts.values, 
                                       labels=education_counts.index, 
                                       autopct='%1.1f%%',
                                       colors=colors,
                                       startangle=90)
    
    ax1.set_title('不同学历的职位数量分布', fontsize=14, fontweight='bold')
    
    # 2. 不同学历的平均薪资和中位数对比
    ax2 = axes[0, 1]
    education_stats_sorted = education_stats.sort_values('平均薪资', ascending=False)
    
    x = np.arange(len(education_stats_sorted))
    width = 0.35
    
    bars1 = ax2.bar(x - width/2, education_stats_sorted['平均薪资'], width, 
                    label='平均薪资', color='skyblue', alpha=0.8)
    bars2 = ax2.bar(x + width/2, education_stats_sorted['中位数薪资'], width,
                    label='中位数薪资', color='orange', alpha=0.8)
    
    ax2.set_title('不同学历的平均薪资与中位数对比', fontsize=14, fontweight='bold')
    ax2.set_ylabel('薪资 (K)')
    ax2.set_xticks(x)
    ax2.set_xticklabels(education_stats_sorted.index, rotation=45)
    ax2.legend()
    
    # 添加数值标签
    for bar, value in zip(bars1, education_stats_sorted['平均薪资']):
        ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.3,
                f'{value:.1f}K', ha='center', va='bottom', fontsize=10, fontweight='bold')
    
    for bar, value in zip(bars2, education_stats_sorted['中位数薪资']):
        ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.3,
                f'{value:.1f}K', ha='center', va='bottom', fontsize=10, fontweight='bold')
    
    # 3. 学历-工作经验薪资中位数热力图
    ax3 = axes[1, 0]
    
    # 创建热力图
    im = ax3.imshow(median_pivot.values, cmap='YlOrRd', aspect='auto')
    
    # 设置坐标轴标签
    ax3.set_xticks(np.arange(len(median_pivot.columns)))
    ax3.set_yticks(np.arange(len(median_pivot.index)))
    ax3.set_xticklabels(median_pivot.columns, rotation=45)
    ax3.set_yticklabels(median_pivot.index)
    
    # 在每个格子中显示数值
    for i in range(len(median_pivot.index)):
        for j in range(len(median_pivot.columns)):
            value = median_pivot.iloc[i, j]
            if value > 0:  # 只显示有数据的格子
                count = count_pivot.iloc[i, j]
                text = ax3.text(j, i, f'{value:.1f}K\n({int(count)}个)', 
                               ha="center", va="center", color="black" if value < 15 else "white",
                               fontsize=10, fontweight='bold')
    
    ax3.set_title('学历-工作经验薪资中位数热力图\n(数字表示中位数薪资，括号内为职位数量)', 
                  fontsize=14, fontweight='bold')
    ax3.set_xlabel('工作经验')
    ax3.set_ylabel('学历要求')
    
    # 添加颜色条
    cbar = plt.colorbar(im, ax=ax3)
    cbar.set_label('薪资中位数 (K)')
    
    # 4. 不同工作经验的薪资分布箱线图
    ax4 = axes[1, 1]
    valid_salary = salary_df[salary_df['平均薪资'] > 0]
    
    if not valid_salary.empty:
        sns.boxplot(data=valid_salary, x='工作经验', y='平均薪资', ax=ax4)
        ax4.set_title('不同工作经验的薪资分布', fontsize=14, fontweight='bold')
        ax4.set_ylabel('平均薪资 (K)')
        ax4.tick_params(axis='x', rotation=45)
        
        # 计算并标记中位数
        experience_medians = valid_salary.groupby('工作经验')['平均薪资'].median()
        for i, (exp, median_val) in enumerate(experience_medians.items()):
            ax4.text(i, median_val + 1, f'{median_val:.1f}K', 
                    ha='center', va='bottom', fontweight='bold', 
                    bbox=dict(boxstyle='round,pad=0.3', facecolor='yellow', alpha=0.7))
    
    # 5. 学历薪资分布箱线图（带中位数标记）
    ax5 = axes[2, 0]
    if not valid_salary.empty:
        sns.boxplot(data=valid_salary, x='学历要求', y='平均薪资', ax=ax5)
        ax5.set_title('不同学历的薪资分布（带中位数标记）', fontsize=14, fontweight='bold')
        ax5.set_ylabel('平均薪资 (K)')
        ax5.tick_params(axis='x', rotation=45)
        
        # 计算并标记中位数
        education_medians = valid_salary.groupby('学历要求')['平均薪资'].median()
        for i, (edu, median_val) in enumerate(education_medians.items()):
            ax5.text(i, median_val + 1, f'{median_val:.1f}K', 
                    ha='center', va='bottom', fontweight='bold',
                    bbox=dict(boxstyle='round,pad=0.3', facecolor='lightblue', alpha=0.7))
    
    # 6. 综合散点图：学历vs薪资中位数，点大小表示职位数量
    ax6 = axes[2, 1]
    scatter = ax6.scatter(education_stats['职位数量'], 
                         education_stats['中位数薪资'],
                         s=education_stats['职位数量']*3,  # 点的大小根据职位数量
                         alpha=0.7,
                         c=education_stats['中位数薪资'],
                         cmap='viridis')
    
    # 添加标签
    for i, (edu, row) in enumerate(education_stats.iterrows()):
        ax6.annotate(f'{edu}\n中位数:{row["中位数薪资"]:.1f}K', 
                    (row['职位数量'], row['中位数薪资']),
                    xytext=(5, 5), textcoords='offset points',
                    fontsize=10, fontweight='bold',
                    bbox=dict(boxstyle='round,pad=0.3', facecolor='white', alpha=0.8))
    
    ax6.set_xlabel('职位数量')
    ax6.set_ylabel('薪资中位数 (K)')
    ax6.set_title('职位数量 vs 薪资中位数', fontsize=14, fontweight='bold')
    
    # 添加颜色条
    cbar = plt.colorbar(scatter, ax=ax6)
    cbar.set_label('薪资中位数 (K)')
    
    plt.tight_layout()
    plt.savefig('education_salary_analysis.png', dpi=300, bbox_inches='tight')
    plt.show()

def create_detailed_table(education_stats):
    """
    创建详细的数据表格
    
    Args:
        education_stats (pd.DataFrame): 学历统计
    """
    print("\n" + "="*80)
    print("不同学历的薪资和工作数量详细分析")
    print("="*80)
    
    # 按平均薪资排序
    sorted_stats = education_stats.sort_values('平均薪资', ascending=False)
    
    print(f"{'学历要求':<15} {'职位数量':<10} {'平均薪资':<12} {'中位数薪资':<12} {'平均最低薪资':<15} {'平均最高薪资':<15}")
    print("-" * 80)
    
    for edu, row in sorted_stats.iterrows():
        print(f"{edu:<15} {row['职位数量']:<10.0f} {row['平均薪资']:<12.1f}K {row['中位数薪资']:<12.1f}K "
              f"{row['平均最低薪资']:<15.1f}K {row['平均最高薪资']:<15.1f}K")
    
    print("-" * 80)
    
    # 计算总体统计
    total_jobs = sorted_stats['职位数量'].sum()
    weighted_avg_salary = (sorted_stats['平均薪资'] * sorted_stats['职位数量']).sum() / total_jobs
    
    print(f"\n总体统计:")
    print(f"总职位数量: {total_jobs:.0f}")
    print(f"加权平均薪资: {weighted_avg_salary:.1f}K")
    print(f"最高平均薪资: {sorted_stats['平均薪资'].max():.1f}K ({sorted_stats['平均薪资'].idxmax()})")
    print(f"最低平均薪资: {sorted_stats['平均薪资'].min():.1f}K ({sorted_stats['平均薪资'].idxmin()})")

def create_cross_analysis_table(cross_stats, median_pivot):
    """
    创建学历-工作经验交叉分析表格
    
    Args:
        cross_stats (pd.DataFrame): 交叉统计数据
        median_pivot (pd.DataFrame): 中位数透视表
    """
    print("\n" + "="*100)
    print("学历-工作经验薪资中位数交叉分析表")
    print("="*100)
    
    print("\n薪资中位数透视表 (单位: K):")
    print("-" * 100)
    
    # 打印表头
    header = f"{'学历要求':<15}"
    for exp in median_pivot.columns:
        header += f"{exp:<15}"
    print(header)
    print("-" * 100)
    
    # 打印数据行
    for edu in median_pivot.index:
        row = f"{edu:<15}"
        for exp in median_pivot.columns:
            value = median_pivot.loc[edu, exp]
            if value > 0:
                row += f"{value:.1f}K{'':<10}"
            else:
                row += f"{'--':<15}"
        print(row)
    
    print("-" * 100)
    
    # 显示详细的交叉统计
    print("\n详细交叉分析 (前20个组合，按中位数薪资排序):")
    print("-" * 100)
    print(f"{'学历要求':<15} {'工作经验':<15} {'职位数量':<10} {'平均薪资':<12} {'中位数薪资':<12}")
    print("-" * 100)
    
    # 按中位数薪资排序，显示前20个
    top_combinations = cross_stats.sort_values('中位数薪资', ascending=False).head(20)
    
    for (edu, exp), row in top_combinations.iterrows():
        print(f"{edu:<15} {exp:<15} {row['职位数量']:<10.0f} {row['平均薪资']:<12.1f}K {row['中位数薪资']:<12.1f}K")
    
    print("-" * 100)

def analyze_salary_trends(salary_df):
    """
    分析薪资趋势
    
    Args:
        salary_df (pd.DataFrame): 薪资数据
    """
    print("\n" + "="*50)
    print("薪资趋势分析")
    print("="*50)
    
    # 薪资分布统计
    salary_ranges = {
        '0-5K': len(salary_df[salary_df['平均薪资'] <= 5]),
        '5-10K': len(salary_df[(salary_df['平均薪资'] > 5) & (salary_df['平均薪资'] <= 10)]),
        '10-15K': len(salary_df[(salary_df['平均薪资'] > 10) & (salary_df['平均薪资'] <= 15)]),
        '15-20K': len(salary_df[(salary_df['平均薪资'] > 15) & (salary_df['平均薪资'] <= 20)]),
        '20-30K': len(salary_df[(salary_df['平均薪资'] > 20) & (salary_df['平均薪资'] <= 30)]),
        '30K+': len(salary_df[salary_df['平均薪资'] > 30])
    }
    
    print("薪资分布:")
    for range_name, count in salary_ranges.items():
        percentage = (count / len(salary_df)) * 100
        print(f"{range_name}: {count} 个职位 ({percentage:.1f}%)")

def main():
    """
    主函数
    """
    print("BOSS直聘职位数据分析工具 - 升级版")
    print("="*60)
    print("新增功能: 学历-工作经验交叉分析与薪资中位数标记")
    print("="*60)
    
    # 加载数据
    df = load_and_clean_data()
    if df is None:
        print("无法加载数据，请检查CSV文件是否存在")
        return
    
    # 分析学历与薪资关系
    education_stats, salary_df = analyze_education_salary(df)
    
    if education_stats.empty:
        print("没有有效的薪资数据进行分析")
        return
    
    # 进行学历-工作经验交叉分析
    cross_stats, median_pivot, count_pivot = analyze_education_experience_salary(salary_df)
    
    # 创建可视化图表
    create_visualizations(df, education_stats, salary_df, cross_stats, median_pivot, count_pivot)
    
    # 显示详细表格
    create_detailed_table(education_stats)
    
    # 显示交叉分析表格
    create_cross_analysis_table(cross_stats, median_pivot)
    
    # 分析薪资趋势
    analyze_salary_trends(salary_df)
    
    print(f"\n分析完成！图表已保存为 'education_salary_analysis.png'")
    print("新增功能包括:")
    print("1. 学历-工作经验薪资中位数热力图")
    print("2. 所有图表中的中位数数值标记")
    print("3. 详细的交叉分析统计表")
    print("4. 更丰富的可视化展示")

if __name__ == "__main__":
    main() 